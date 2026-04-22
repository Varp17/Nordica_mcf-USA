-- Update generate_order_number to support FAKE orders
DROP PROCEDURE IF EXISTS generate_order_number;

DELIMITER $$

CREATE PROCEDURE generate_order_number(IN p_country VARCHAR(2), IN p_is_fake TINYINT(1), OUT new_order_number VARCHAR(25))
BEGIN
  DECLARE next_number INT;
  DECLARE v_prefix    VARCHAR(10);
  DECLARE v_fake_tag  VARCHAR(10) DEFAULT '';
  
  IF p_is_fake = 1 THEN
    SET v_fake_tag = 'FAKE-';
  END IF;
  
  IF p_country = 'CA' THEN
    SET v_prefix = 'DG-';
    INSERT INTO order_sequences (year, month, last_number, prefix)
      VALUES (1, 1, 10001, v_prefix)
    ON DUPLICATE KEY UPDATE last_number = last_number + 1;
    
    SELECT last_number INTO next_number FROM order_sequences WHERE year = 1 AND month = 1;
  ELSE
    SET v_prefix = 'NDUS-';
    INSERT INTO order_sequences (year, month, last_number, prefix)
      VALUES (2, 1, 50001, v_prefix)
    ON DUPLICATE KEY UPDATE last_number = last_number + 1;
    
    SELECT last_number INTO next_number FROM order_sequences WHERE year = 2 AND month = 1;
  END IF;
  
  SET new_order_number = CONCAT(v_prefix, v_fake_tag, next_number);
END$$

DELIMITER ;
